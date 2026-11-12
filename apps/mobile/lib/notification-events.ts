/** Public event identities contain no invitation secrets or account credentials. */
export const CONNECTION_KINDS = new Set([
  "friend_requested",
  "friend_accepted",
  "friend_rejected",
  "friend_cancelled",
  "friend_removed",
  "vault_invite_requested",
  "vault_invite_accepted",
  "vault_invite_rejected",
  "vault_invite_cancelled",
  "vault_member_return_requested",
  "vault_member_removed",
  "vault_member_left",
  "vault_member_role_changed",
  "shared_invite_requested",
  "shared_invite_cancelled",
]);
const REQUEST_KINDS = new Set([
  "friend_requested",
  "vault_invite_requested",
  "shared_invite_requested",
]);
export const isRequestedConnectionNotice = (kind: unknown): boolean =>
  REQUEST_KINDS.has(String(kind));
export type NotificationEvent = {
  kind?: unknown;
  id?: unknown;
  notification_id?: unknown;
  source_id?: unknown;
  tab_id?: unknown;
  entry_id?: unknown;
  rev?: unknown;
  recipient_account_id?: unknown;
};
export function isConnectionNotice(data: NotificationEvent): boolean {
  return typeof data.kind === "string" && CONNECTION_KINDS.has(data.kind);
}
export function notificationEventKey(owner: string, data: NotificationEvent): string | null {
  const kind = String(data.kind ?? "");
  if (REQUEST_KINDS.has(kind) && typeof data.source_id === "string" && data.source_id)
    return `${owner}:connection:${kind}:${data.source_id}`;
  if (isConnectionNotice(data)) {
    const id = data.notification_id ?? data.id;
    return typeof id === "string" && id ? `${owner}:connection:${id}` : null;
  }
  const rev = Number(data.rev);
  if (typeof data.tab_id === "string" && data.tab_id && Number.isSafeInteger(rev) && rev > 0)
    return `${owner}:tab:${data.tab_id}:${typeof data.entry_id === "string" ? data.entry_id : ""}:${rev}`;
  return null;
}
/** These are final decisions, still meaningful after the relationship closes. */
export function noticeAllowedAfterUnlink(kind: unknown): boolean {
  return [
    "unlinked",
    "settled",
    "entry_accepted",
    "entry_rejected",
    "entry_voided",
    "entry_removal_approved",
    "entry_removal_declined",
    "invitation_accepted",
    "invitation_declined",
  ].includes(String(kind));
}
export type PendingNotificationRequests = {
  friends: readonly { id: string }[];
  members: readonly { id: string }[];
  shared: readonly { id: string }[];
};
export function noticeHasRequestCard(
  item: NotificationEvent,
  pending: PendingNotificationRequests,
): boolean {
  const rows =
    item.kind === "friend_requested"
      ? pending.friends
      : item.kind === "vault_invite_requested"
        ? pending.members
        : item.kind === "shared_invite_requested"
          ? pending.shared
          : [];
  return rows.some((row) => row.id === item.source_id);
}
export function notificationBadgeCount(
  page: {
    unread: number;
    request_unread?: number;
    items: readonly (NotificationEvent & { read: boolean })[];
  },
  pending: PendingNotificationRequests,
): number {
  const pendingCount = pending.friends.length + pending.members.length + pending.shared.length;
  if (typeof page.request_unread === "number" && Number.isFinite(page.request_unread)) {
    const requestUnread = Math.max(0, Math.min(page.unread, page.request_unread));
    return Math.max(0, page.unread - requestUnread) + Math.max(requestUnread, pendingCount);
  }
  return (
    Math.max(
      0,
      page.unread -
        page.items.filter((item) => !item.read && noticeHasRequestCard(item, pending)).length,
    ) + pendingCount
  );
}
type NoticeChange = { account: string; source: "push" | "poll" | "local" };
const listeners = new Set<(change: NoticeChange) => void>();
export function onNotificationInboxChanged(listener: (change: NoticeChange) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function notifyNotificationInboxChanged(
  account: string,
  source: NoticeChange["source"],
): void {
  for (const listener of listeners) {
    try {
      listener({ account, source });
    } catch {
      /* Isolated UI subscriber. */
    }
  }
}
