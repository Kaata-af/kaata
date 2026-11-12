import { AppState } from "react-native";
import { captureCurrentSession, applyForCurrentSession } from "./auth";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "./db-tx";
import { getLocale, subscribeLocale } from "./i18n";
import { playForegroundNotificationCue } from "./foreground-notification-cue";
import { claimNotificationDelivery, notificationWasDelivered } from "./notification-delivery";
import {
  isConnectionNotice,
  notificationEventKey,
  noticeAllowedAfterUnlink,
  notifyNotificationInboxChanged,
  onNotificationInboxChanged,
} from "./notification-events";
import { notificationAllowed } from "./notification-policy";
import {
  notificationOwnerScope,
  notificationPolicyForContact,
  notificationPolicyForTab,
  notificationPreferencesRevision,
} from "./notification-preferences";
import { fetchInbox, type InboxItem } from "./tabs/api";
import { listTabLinksForId } from "./tabs/db";
import { isTabVaultRevoked } from "./tabs/binding-access";
import { onTabApplied } from "./tabs/events";
import { announceServerReads, pendingInboxReadSpecs, inboxItemMatches } from "./tabs/inbox-reads";

export async function cueInboxNotification(
  item: InboxItem,
  account: string,
  isCurrent: () => boolean,
): Promise<void> {
  const revision = notificationPreferencesRevision();
  const owner = notificationOwnerScope();
  const current = () =>
    isCurrent() &&
    getSessionAccountIdSync() === account &&
    notificationPreferencesRevision() === revision &&
    notificationOwnerScope() === owner &&
    AppState.currentState === "active";
  if (
    !current() ||
    item.read ||
    item.actor_account_id === account ||
    (item.recipient_account_id && item.recipient_account_id !== account)
  )
    return;
  const key = notificationEventKey(owner, item);
  if (!key) return;
  let policy;
  if (isConnectionNotice(item)) policy = await notificationPolicyForContact();
  else {
    const matches = (await listTabLinksForId(item.tab_id)).filter(
      (link) => !item.role || link.role === item.role,
    );
    if (matches.length !== 1) return;
    const link = matches[0];
    if (await isTabVaultRevoked(link.vault_id)) return;
    if (link.closed_at != null && !noticeAllowedAfterUnlink(item.kind)) return;
    policy = await notificationPolicyForTab(link);
  }
  if (!current() || !notificationAllowed(policy, item.kind)) return;
  if ((await notificationWasDelivered(account, key)) || !current()) return;
  if (policy.foreground) {
    const { presentForegroundInboxNotification } = await import("./tabs/notify");
    if (await presentForegroundInboxNotification(item, policy, current)) return;
  }
  if (await claimNotificationDelivery(account, key, current))
    playForegroundNotificationCue(policy, current, key);
}

/** One observer at the application root, independent of which page is visible.
 * Native delivery and this foreground fallback share durable event receipts. */
export function startNotificationObserver(): () => void {
  let epoch = 0,
    disposed = false,
    busy = false,
    trailing = false;
  let signature = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observedId: bigint | null = null;
  const noticeId = (value: string) => (/^\d+$/.test(value) ? BigInt(value) : 0n);
  const reload = async () => {
    if (disposed || AppState.currentState !== "active") return;
    if (busy) {
      trailing = true;
      return;
    }
    const account = getSessionAccountIdSync();
    if (!account) return;
    const run = epoch,
      locale = getLocale();
    const current = () =>
      !disposed && run === epoch && account === getSessionAccountIdSync() && locale === getLocale();
    busy = true;
    try {
      const session = await captureCurrentSession();
      if (!current() || !session.jwt || session.accountId !== account) return;
      const page = await fetchInbox(locale);
      await applyForCurrentSession(session, async () => {});
      if (!current()) return;
      const reads = await pendingInboxReadSpecs(account);
      if (!current()) return;
      // First successful read of a foreground session is a silent baseline.
      // Server IDs, not phone/server wall-clock comparisons, order new events.
      // Receipts still dedupe native push against subsequent foreground polls.
      for (const item of [...page.items].reverse()) {
        if (!current()) return;
        if (
          observedId !== null &&
          noticeId(item.id) > observedId &&
          !reads.some((spec) => inboxItemMatches(item, spec))
        )
          await cueInboxNotification(item, account, current);
      }
      if (!current()) return;
      announceServerReads(page.items);
      observedId = [
        observedId ?? 0n,
        noticeId(page.latest_id),
        ...page.items.map((item) => noticeId(item.id)),
      ].reduce((a, b) => (a > b ? a : b), 0n);
      const nextSignature = `${account}:${locale}:${page.latest_id}:${page.unread}:${page.items.map((item) => `${item.id}:${item.read}`).join(",")}`;
      if (signature !== nextSignature) {
        signature = nextSignature;
        notifyNotificationInboxChanged(account, "poll");
      }
    } catch {
      /* Transient network errors keep the last observed cursor. */
    } finally {
      if (run === epoch) {
        busy = false;
        if (trailing) {
          trailing = false;
          void reload();
        }
      }
    }
  };
  const wake = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reload(), 200);
  };
  const reset = () => {
    epoch++;
    busy = false;
    trailing = false;
    signature = "";
    observedId = null;
    wake();
    void import("./tabs/notify")
      .then((service) => service.syncTabPushSubscriptions())
      .catch(() => undefined);
  };
  const offAccount = onAccountIdentityChanged(reset);
  const offLocale = subscribeLocale(reset);
  const offNotice = onNotificationInboxChanged((change) => {
    if (change.account === getSessionAccountIdSync() && change.source !== "poll") wake();
  });
  const offTab = onTabApplied(wake);
  const app = AppState.addEventListener("change", (state) => {
    epoch++;
    busy = false;
    trailing = false;
    observedId = null;
    if (state === "active") {
      wake();
    }
  });
  const poll = setInterval(() => void reload(), 15_000);
  reset();
  return () => {
    disposed = true;
    epoch++;
    offAccount();
    offLocale();
    offNotice();
    offTab();
    app.remove();
    clearInterval(poll);
    if (timer) clearTimeout(timer);
  };
}
