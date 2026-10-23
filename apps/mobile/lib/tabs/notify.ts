// App-wide notification bootstrap, imported by index.js in foreground and headless VMs.
// Never import expo-notifications in Expo Go (Android throws during module load).
import { AppState, Platform } from "react-native";
import { isRunningInExpoGo } from "expo";
import Constants from "expo-constants";
import * as TaskManager from "expo-task-manager";
import { getAppMeta, setAppMeta } from "../db";
import { getAccountIdSync, getInstallIdSync } from "../db-tx";
import { applyForCurrentSession, captureCurrentSession } from "../auth";
import { getLocale, subscribeLocale, t, tIn, type LocaleCode } from "../i18n";
import { getTabLink, listTabLinks, queueNotificationReview } from "./db";
import { registerTabNotifications, resolveTabAuth } from "./api";
import { setTabPushRefreshHook, syncTab, requestTabSync } from "./sync";
import { onTabApplied } from "./events";
import { markInboxHandled, onInboxReadsApplied, type InboxReadSpec } from "./inbox-reads";
import { setTabNotifyHook } from "./link";
import { parseTabReview, TAB_ACCEPT, TAB_REJECT } from "./notification-data";
import { notificationVars } from "./notification-text";
import type { TabEntryRow } from "./types";
import type { NotificationResponse, NotificationTaskPayload } from "expo-notifications";

const TASK = "kaata-tab-notification-actions";
const CHANNEL = "tab-updates";
const ASKED = "tab_notify_asked";
let nextRegistration = 0;
let registrationAccount: string | null = null;
let registrationLocale: LocaleCode | null = null;
let registering: Promise<void> | null = null;
let notificationsPromise: Promise<typeof import("expo-notifications")> | null = null;
const processing = new Map<string, Promise<void>>();

/** Closing sharing mutes alerts, independently of the remaining review rights. */
async function isClosedTabNotice(data: unknown): Promise<boolean> {
  const tabId = (data as { tab_id?: unknown } | null)?.tab_id;
  if (typeof tabId !== "string") return false;
  return (await getTabLink(tabId))?.closed_at != null;
}

async function notifications() {
  if (isRunningInExpoGo()) return null;
  notificationsPromise ??= import("expo-notifications").catch((err) => {
    notificationsPromise = null;
    throw err;
  });
  return notificationsPromise;
}

async function configure(n: typeof import("expo-notifications")) {
  await n.setNotificationChannelAsync(CHANNEL, {
    name: t("tab.notify.channel"),
    description: t("tab.notify.channelDescription"),
    importance: n.AndroidImportance.DEFAULT,
  });
  // Stable locale-specific IDs let a message use its registration's locale,
  // even if another device has since changed the account language.
  for (const locale of ["en", "fa", "ps"] as const) {
    await n.setNotificationCategoryAsync("tab-review-" + locale, [
      {
        identifier: TAB_ACCEPT,
        buttonTitle: "✓ " + tIn(locale, "tab.accept"),
        options: { opensAppToForeground: false, isAuthenticationRequired: true },
      },
      {
        identifier: TAB_REJECT,
        buttonTitle: "× " + tIn(locale, "tab.reject"),
        options: { opensAppToForeground: false, isAuthenticationRequired: true },
      },
    ]);
  }
}

/** Both native response paths use the same durable outbox receipt. Payload
 * IDs choose the target; session + server membership alone authorize it. */
async function review(action: string, data: unknown, notificationId: string) {
  const parsed = parseTabReview(action, data);
  if (!parsed) return;
  const key = parsed.tabId + ":" + parsed.entryId + ":" + parsed.rev;
  const existing = processing.get(key);
  if (existing) return existing;
  const work = (async () => {
    const session = await captureCurrentSession();
    const link = await getTabLink(parsed.tabId);
    if (!link || link.role !== parsed.role) return;
    // Never turn a signed-out tap into an operation for a later account.
    await resolveTabAuth(link);
    await applyForCurrentSession(session, async () => {
      await queueNotificationReview(link, parsed.entryId, parsed.rev, parsed.action);
      // Bind the durable intent and its handled notice to the account that
      // tapped. Authentication can finish after a different account signs in.
      // The payload's rev names the notice; the entry is only a tray hint.
      void markInboxHandled({ tab_id: parsed.tabId, rev: parsed.rev, entry_id: parsed.entryId });
    });
    const n = await notifications();
    // Durable now. A weak connection retries through the existing ordered
    // outbox; current server authority and the entry's first decision govern
    // this explicit action even after sharing has closed.
    await n?.dismissNotificationAsync(notificationId);
    await syncTab(link.tab_id);
  })().finally(() => processing.delete(key));
  processing.set(key, work);
  return work;
}

async function handleResponse(response: NotificationResponse) {
  try {
    await review(
      response.actionIdentifier,
      response.notification.request.content.data,
      response.notification.request.identifier,
    );
    const { notificationActions } = await import("../../modules/kaata-notification-actions");
    await notificationActions?.complete(response.notification.request.identifier);
  } catch {
    // No successful receipt = no claim of success. iOS retains its native
    // handoff; Android offers an explicit retry by opening the notification.
    const data = response.notification.request.content.data;
    if (await isClosedTabNotice(data).catch(() => false)) return;
    const n = await notifications().catch(() => null);
    await n
      ?.scheduleNotificationAsync({
        content: {
          title: "Kaata",
          body: t("tab.notify.actionFailed"),
          data,
        },
        trigger: { channelId: CHANNEL },
      })
      .catch(() => undefined);
  }
}

async function drainNativeReviews() {
  if (Platform.OS !== "ios") return;
  const { notificationActions } = await import("../../modules/kaata-notification-actions");
  for (const pending of (await notificationActions?.pending()) ?? []) {
    try {
      await review(pending.action, pending.data, pending.id);
      await notificationActions?.complete(pending.id);
    } catch {
      /* keychain locked / DB booting: native handoff stays durable */
    }
  }
}

// Android delivers background action responses through TaskManager, whereas
// iOS delivers UNNotificationResponse; its native handoff grants bounded time
// and persists a tap before the JS runtime is ready.
TaskManager.defineTask<NotificationTaskPayload>(TASK, async ({ data, error }) => {
  if (error || !data || !("actionIdentifier" in data)) return;
  await handleResponse(data);
});

async function bootstrap() {
  const n = await notifications();
  if (!n) return;
  n.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data;
      // A customer reminder is an alarm the user set for themselves: it must
      // alert even while Kaata is open, where it used to be silently dropped.
      // Shared-account notices do not alert in the foreground, their own
      // author, or a closed relationship. Server delivery applies the same
      // close gate; this also catches an already-sent, late arrival.
      const show =
        data?.kind === "customer_reminder" ||
        ((AppState.currentState === "background" || AppState.currentState === "inactive") &&
          !(
            typeof data?.actor_account_id === "string" &&
            data.actor_account_id === getAccountIdSync()
          ) &&
          !(await isClosedTabNotice(data).catch(() => false)));
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: show,
        shouldSetBadge: false,
      };
    },
  });
  n.addNotificationResponseReceivedListener((r) => {
    void handleResponse(r);
  });
  n.addNotificationReceivedListener((r) => {
    const id = r.request.content.data?.tab_id;
    if (typeof id === "string") requestTabSync(id);
  });
  await configure(n);
  if (Platform.OS === "android") await n.registerTaskAsync(TASK);
  const last = await n.getLastNotificationResponseAsync();
  if (last) await handleResponse(last);
  await drainNativeReviews();
}
if (!isRunningInExpoGo()) void bootstrap().catch(() => undefined);

export function syncTabPushSubscriptions(): Promise<void> {
  // Serialize requests so an older response cannot overwrite a newer language
  // on the server. The follow-up always reads the latest account and locale.
  if (registering) {
    return registering.then(() => {
      if (getAccountIdSync() !== registrationAccount || getLocale() !== registrationLocale)
        return syncTabPushSubscriptions();
    });
  }
  const account = getAccountIdSync();
  const locale = getLocale();
  const current = () => account === getAccountIdSync() && locale === getLocale();
  if (account !== registrationAccount || locale !== registrationLocale) {
    nextRegistration = 0;
    registrationAccount = account;
    registrationLocale = locale;
  }
  if (!account) return Promise.resolve();
  if (Date.now() < nextRegistration) return Promise.resolve();
  registering = (async () => {
    await drainNativeReviews();
    const links = await listTabLinks();
    if (!current() || !links.length) return;
    const n = await notifications();
    if (!n) return;
    await configure(n);
    let permission = await n.getPermissionsAsync();
    if (!current()) return;
    // Upgrades/restores already have links, so the create/join hook may never
    // run again. Ask once during a signed-in FOREGROUND sweep as well. Never
    // prompt from a notification's headless/background execution.
    if (
      AppState.currentState === "active" &&
      !permission.granted &&
      permission.canAskAgain &&
      (await getAppMeta(ASKED)) !== "1"
    ) {
      await resolveTabAuth(links[0]);
      if (!current()) return;
      permission = await n.requestPermissionsAsync();
      await setAppMeta(ASKED, "1");
    }
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const token = permission.granted ? (await n.getExpoPushTokenAsync({ projectId })).data : "";
    let enabled = false;
    let failed = false;
    for (const link of links) {
      if (!current()) return;
      try {
        const auth = await resolveTabAuth(link);
        if (!current()) return;
        const result = await registerTabNotifications(auth, link.tab_id, {
          install_id: getInstallIdSync(),
          token,
          locale,
        });
        if (!current()) return;
        const active = result.enabled && !!token;
        enabled ||= active;
        await setAppMeta("tab_push_active:" + link.tab_id, active ? String(Date.now()) : "0");
      } catch {
        failed = true;
      }
    }
    if (!current()) return;
    await setAppMeta("tab_push_active", enabled ? "1" : "0");
    if (!current()) return;
    await setAppMeta(
      "tab_push_error",
      failed
        ? "registration_failed"
        : enabled
          ? ""
          : permission.granted
            ? "server_disabled"
            : "permission_denied",
    );
    if (current()) nextRegistration = Date.now() + (failed ? 60_000 : 3600_000);
  })()
    .catch(async () => {
      if (!current()) return;
      nextRegistration = Date.now() + 60_000;
      await setAppMeta("tab_push_active", "0").catch(() => undefined);
      if (!current()) return;
      await setAppMeta("tab_push_error", "credentials_or_network").catch(() => undefined);
    })
    .finally(() => {
      registering = null;
    });
  return registering;
}

export async function ensureTabNotificationPermission() {
  nextRegistration = 0;
  await syncTabPushSubscriptions();
}

// Foreground pulls only refresh UI. Background fallback alerts are used only
// when remote delivery is unavailable, and never for our own write/ack.
onTabApplied((ev) => {
  if (AppState.currentState === "active" || ev.origin !== "pull" || !ev.changes?.length) return;
  void (async () => {
    const registered = Number(await getAppMeta("tab_push_active:" + ev.tabId));
    if (registered && Date.now() - registered < 2 * 3600_000) return;
    const n = await notifications();
    const link = await getTabLink(ev.tabId);
    if (!n || !link || link.closed_at != null) return;
    await configure(n);
    const { readVaultRole, canPerformAction } = await import("../use-vault-role");
    const canReview = canPerformAction(
      await readVaultRole(link.vault_id, getAccountIdSync()),
      "entry.amend",
    );
    for (const change of ev.changes!) {
      let body =
        change.kind === "entry_created"
          ? t("tab.notify.newEntries", { count: 1 })
          : t(
              change.kind === "entry_accepted"
                ? "tab.notify.accepted"
                : change.kind === "entry_rejected"
                  ? "tab.notify.rejected"
                  : "tab.notify.voided",
            );
      const { getDb } = await import("../db-tx");
      const entry = await (
        await getDb()
      ).getFirstAsync<TabEntryRow>(
        "SELECT * FROM tab_entries WHERE id=? AND tab_id=?",
        change.entryId,
        ev.tabId,
      );
      // A pull/ack can race a local write. Never alert the writer or replay
      // stale state as a new tally. Remote push is the main background path.
      if (AppState.currentState === "active") return;
      if (
        change.kind === "entry_created" &&
        (!entry ||
          entry.created_by === link.role ||
          entry.author_account_id === getAccountIdSync() ||
          entry.local_pending ||
          entry.status !== "pending" ||
          entry.voided_by_entry_id)
      )
        continue;
      if (change.kind === "entry_voided") continue; // our side's own cancellation
      if (entry) {
        body = t(
          change.kind === "entry_created"
            ? "tab.notify.detail.new"
            : change.kind === "entry_accepted"
              ? "tab.notify.detail.accepted"
              : change.kind === "entry_rejected"
                ? "tab.notify.detail.rejected"
                : "tab.notify.detail.voided",
          notificationVars(link, entry, t("tab.them")),
        );
      }
      // A local unlink can finish while the entry and native adapters load.
      const current = await getTabLink(ev.tabId);
      if (!current || current.closed_at != null) return;
      await n.scheduleNotificationAsync({
        identifier: `tab:${ev.tabId}:${change.entryId}:${change.rev}`,
        content: {
          title: t("tab.notify.fallbackTitle"),
          body,
          data: {
            tab_id: ev.tabId,
            entry_id: change.entryId,
            rev: change.rev,
            role: link.role,
            kind: change.kind,
          },
          categoryIdentifier:
            canReview && change.kind === "entry_created" ? "tab-review-" + getLocale() : undefined,
        },
        trigger: { channelId: CHANNEL },
      });
    }
  })().catch(() => undefined);
});

/**
 * Whether a notification sitting in the tray is about the notice(s) `spec`
 * handled. Both the server push and the local fallback carry
 * {tab_id, entry_id?, rev} in `data` (FCM may stringify the rev). The same
 * precedence as the server body (lib/tabs/inbox-reads.ts toReadBody): an
 * exact rev names ONE notice, a through_rev a range, the entry only when no
 * rev is known; "mark all" ({through}) clears every tab notification, and a
 * spec that names neither rev nor entry vouches for nothing.
 */
function trayMatches(data: Record<string, unknown> | undefined, spec: InboxReadSpec): boolean {
  if (typeof data?.tab_id !== "string") return false;
  if ("through" in spec) return true;
  if (!spec.tab_id || data.tab_id !== spec.tab_id) return false;
  const rev = Number(data.rev);
  if ("through_rev" in spec) return rev <= spec.through_rev;
  if (typeof spec.rev === "number") return rev === spec.rev;
  if (spec.entry_id) return data.entry_id === spec.entry_id;
  return false;
}

// A handled notice leaves the OS tray too. The server stops sending a push
// once it holds the read row, but one already showing stays until the app
// dismisses it — and "I accepted it in the app, why is it still on my lock
// screen" is the same complaint as the unread bell. The same for a read the
// server reports (the other phone on the account reviewed it). Best-effort;
// Expo Go has no tray to clear. One tray read per announcement, batch or not.
onInboxReadsApplied((specs) => {
  void (async () => {
    const n = await notifications();
    if (!n) return;
    for (const shown of await n.getPresentedNotificationsAsync()) {
      if (specs.some((spec) => trayMatches(shown.request.content.data, spec)))
        await n.dismissNotificationAsync(shown.request.identifier).catch(() => undefined);
    }
  })().catch(() => undefined);
});

/**
 * The tray against the truth: an "Accept or reject it" notification for a
 * tally that is no longer pending (reviewed by this account's other phone or
 * a kaata member, or cancelled by its author) is moot. Closing a relationship
 * separately mutes ALL of its tray alerts, including review outcomes, while
 * retaining its inbox history and pending review rights. The server drops
 * closed-tab pushes while queued; one that was already delivered
 * — a late FCM arrival after the review, or a phone that got it before the
 * account handled it elsewhere — is only ever cleared here. Runs on return to
 * the foreground and after every pull, reads the local cache only, never
 * throws, and leaves anything it cannot vouch for.
 */
async function sweepTray(): Promise<void> {
  const n = await notifications();
  if (!n) return;
  const shown = await n.getPresentedNotificationsAsync();
  if (!shown.length) return;
  const { getDb } = await import("../db-tx");
  const db = await getDb();
  const links = new Map<string, Awaited<ReturnType<typeof getTabLink>>>();
  for (const s of shown) {
    const data = s.request.content.data as Record<string, unknown> | undefined;
    if (typeof data?.tab_id !== "string" || data.kind === "customer_reminder") continue;
    let link = links.get(data.tab_id);
    if (link === undefined) {
      link = await getTabLink(data.tab_id);
      links.set(data.tab_id, link);
    }
    if (link?.closed_at != null) {
      await n.dismissNotificationAsync(s.request.identifier).catch(() => undefined);
      continue;
    }
    if (data.kind !== "entry_created" || typeof data.entry_id !== "string") continue;
    const row = await db.getFirstAsync<Pick<TabEntryRow, "status" | "voided_by_entry_id">>(
      "SELECT status, voided_by_entry_id FROM tab_entries WHERE id=? AND tab_id=?",
      data.entry_id,
      data.tab_id,
    );
    const moot = row != null && (row.status !== "pending" || row.voided_by_entry_id != null);
    if (moot) await n.dismissNotificationAsync(s.request.identifier).catch(() => undefined);
  }
}
AppState.addEventListener("change", (state) => {
  if (state === "active") void sweepTray().catch(() => undefined);
});
onTabApplied((ev) => {
  if (ev.origin === "pull") void sweepTray().catch(() => undefined);
  else
    void getTabLink(ev.tabId)
      .then((link) => (link?.closed_at != null ? sweepTray() : undefined))
      .catch(() => undefined);
});
setTabNotifyHook(ensureTabNotificationPermission);
setTabPushRefreshHook(syncTabPushSubscriptions);
// Refresh server-side push copy on a language change even when the regular
// hourly subscription refresh would otherwise be throttled.
subscribeLocale(() => void syncTabPushSubscriptions().catch(() => undefined));
