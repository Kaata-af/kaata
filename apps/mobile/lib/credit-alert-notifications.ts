import { isRunningInExpoGo } from "expo";
import { AppState, Platform } from "react-native";
import { sha256 } from "@noble/hashes/sha256";
import {
  getDb,
  getInstallIdSync,
  getSessionAccountIdSync,
  onAccountIdentityChanged,
  setActiveVaultId,
  type SQLiteTx,
} from "./db-tx";
import { canReadReminderVault } from "./customer-reminders";
import { getReminderDeviceId } from "./reminder-device";
import {
  creditAlertBalancesInTx,
  listEffectiveCreditAlertCustomers,
  readEffectiveCreditAlertPolicy,
  type CreditAlertCustomer,
} from "./credit-alerts";
import {
  creditAlertFingerprint,
  evaluateCreditAlertDirection,
  type CreditAlertDirection,
  type CreditAlertMatch,
  type CreditAlertPolicy,
} from "./credit-alert-policy";
import { onCreditPoliciesChanged } from "./credit-policy-events";
import { onLedgerApplied } from "./ledger-events";
import { onTabApplied } from "./tabs/events";
import {
  notificationOwnerScope,
  notificationPolicyForContact,
  notificationPreferencesRevision,
  onNotificationPreferencesChanged,
} from "./notification-preferences";
import { notificationAllowed, type NotificationPolicy } from "./notification-policy";
import { getLocale, subscribeLocale, t } from "./i18n";
import { readVaultRole } from "./use-vault-role";
import { getBackendUrl } from "./api";
import { captureCurrentSession } from "./auth";
import {
  creditAlertObservationEpoch,
  creditAlertObservationPaused,
  onCreditAlertObservationResumed,
} from "./credit-alert-observation";
import {
  creditAlertRemoteDeliveryActive,
  syncCreditAlertPushSubscriptions,
} from "./credit-alert-push";

const PREFIX = "kaata-credit-alert:";
const STATE_PREFIX = "credit_alert_latch:v1:";
const CHANNEL = "credit-alerts";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
type Latch = {
  fingerprint: string;
  state: "matched" | "clear" | null;
  sequence: number;
  event_key?: string;
};
type Notice = CreditAlertCustomer & {
  direction: CreditAlertDirection;
  fingerprint: string;
  event_key: string;
  owner: string;
  device: string;
};

let generation = 0;
let tail: Promise<unknown> = Promise.resolve();
let configuredLocale: string | null = null;
let latestTap = 0;
let purgeRemoteTray = true;
const resolving = new Map<string, Promise<AlertData | null>>();
const resolvedData = new WeakMap<object, string>();

function hash(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Each direction has its own episode. Reordering equivalent groups or saving
 * a newer server timestamp cannot create a new episode. */
function fingerprint(policy: CreditAlertPolicy, direction: CreditAlertDirection): string {
  return hash(
    creditAlertFingerprint({
      ...policy,
      groups: policy.groups.filter((g) => g.direction === direction),
    }),
  );
}

function latchScope(owner: string, device: string) {
  return STATE_PREFIX + hash(JSON.stringify([owner, device])) + ":";
}
function latchKey(owner: string, device: string, row: CreditAlertCustomer, direction: string) {
  return (
    latchScope(owner, device) + hash(JSON.stringify([row.vault_id, row.relationship_id, direction]))
  );
}

function parseLatch(value?: string): Latch | null {
  try {
    const latch = JSON.parse(value ?? "null") as Latch | null;
    return latch &&
      typeof latch.fingerprint === "string" &&
      (latch.state === null || latch.state === "matched" || latch.state === "clear") &&
      Number.isSafeInteger(latch.sequence) &&
      latch.sequence >= 0 &&
      (latch.event_key === undefined || typeof latch.event_key === "string")
      ? latch
      : null;
  } catch {
    return null;
  }
}

/** Unknown observations never clear a known episode. First observations and
 * changed configurations establish a quiet baseline, including after restore. */
export function advanceCreditAlertLatch(
  previous: Latch | null,
  semanticFingerprint: string,
  match: CreditAlertMatch,
): { latch: Latch; crossing: boolean } {
  const before =
    previous?.fingerprint === semanticFingerprint
      ? previous
      : { fingerprint: semanticFingerprint, state: null, sequence: 0 };
  if (match === "unknown") return { latch: before, crossing: false };
  const crossing = before.state === "clear" && match === "matched";
  return {
    latch: {
      fingerprint: semanticFingerprint,
      state: match,
      sequence: before.sequence + Number(crossing),
      ...(match === "matched" && before.event_key ? { event_key: before.event_key } : {}),
    },
    crossing,
  };
}

async function readLatch(tx: SQLiteTx, key: string) {
  return parseLatch(
    (await tx.getFirstAsync<{ value: string }>("SELECT value FROM app_meta WHERE key=?", key))
      ?.value,
  );
}

function channel(policy: Pick<NotificationPolicy, "sound" | "vibration">) {
  return `${CHANNEL}-s${Number(policy.sound)}-v${Number(policy.vibration)}`;
}

async function native() {
  // This service shares the signed app's notification presentation handler.
  if (isRunningInExpoGo()) return null;
  return import("expo-notifications");
}

async function canReceive(db: SQLiteTx, vaultId: string): Promise<boolean> {
  if (!(await canReadReminderVault(db, vaultId))) return false;
  const role = await readVaultRole(vaultId, getSessionAccountIdSync());
  return role === "owner" || role === "manager";
}

type AlertData = {
  kind: "credit_alert";
  owner_scope: string;
  vault_id: string;
  relationship_id: string;
  person_id: string;
  direction: CreditAlertDirection;
  rule_fingerprint?: string;
  event_key: string;
  device_scope?: string;
  policy_key?: string;
  policy_updated_at_ms?: number | string;
};

function parseData(value: unknown): AlertData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as AlertData;
  return data.kind === "credit_alert" &&
    typeof data.owner_scope === "string" &&
    UUID.test(data.vault_id ?? "") &&
    UUID.test(data.relationship_id ?? "") &&
    UUID.test(data.person_id ?? "") &&
    (data.direction === "collect" || data.direction === "pay") &&
    typeof data.event_key === "string" &&
    data.event_key.length > 0 &&
    data.event_key.length <= 256 &&
    (data.rule_fingerprint === undefined || typeof data.rule_fingerprint === "string") &&
    (data.device_scope === undefined || typeof data.device_scope === "string")
    ? data
    : null;
}

/** Remote providers receive one random event ID and generic text. Resolve its
 * private routing details through the authenticated server before reading any
 * contact policy or navigating. Full local payloads never leave this phone. */
export async function resolveCreditAlertNotificationData(
  value: unknown,
): Promise<AlertData | null> {
  const local = parseData(value);
  if (local?.device_scope !== undefined) return local;
  const opaque = value as { kind?: unknown; event_key?: unknown } | null;
  if (
    opaque?.kind !== "credit_alert" ||
    typeof opaque.event_key !== "string" ||
    !UUID.test(opaque.event_key)
  )
    return null;
  const eventKey = opaque.event_key;
  const session = await captureCurrentSession();
  const owner = notificationOwnerScope();
  const install = getInstallIdSync();
  if (!session.jwt || !session.accountId || owner !== `account:${session.accountId}`) return null;
  const scope = `${owner}:${session.bindingVersion}:${install}:${eventKey}`;
  const current = () => notificationOwnerScope() === owner && getInstallIdSync() === install;
  if (local && resolvedData.get(local) === scope) return local;
  const existing = resolving.get(scope);
  if (existing) return existing;
  const work = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(
        `${await getBackendUrl()}/v1/sync/credit-alerts/events/${encodeURIComponent(eventKey)}`,
        {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${session.jwt}`, "X-Kaata-Currencies": "1" },
        },
      );
      if (!response.ok || !current()) return null;
      const data = parseData(await response.json());
      const fresh = await captureCurrentSession();
      if (
        !data ||
        data.event_key !== eventKey ||
        data.owner_scope !== owner ||
        !current() ||
        fresh.bindingVersion !== session.bindingVersion ||
        fresh.accountId !== session.accountId
      )
        return null;
      resolvedData.set(data, scope);
      return data;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => resolving.delete(scope));
  resolving.set(scope, work);
  return work;
}

/** IDs in a notification are hints, never read authority. Called again by the
 * foreground handler and tap router, after any await that could change scope. */
export async function creditAlertNoticeAllowed(value: unknown): Promise<boolean> {
  const observationEpoch = creditAlertObservationEpoch();
  if (creditAlertObservationPaused()) return false;
  const data = await resolveCreditAlertNotificationData(value);
  const owner = notificationOwnerScope();
  if (!data || data.owner_scope !== owner) return false;
  const device = await getReminderDeviceId();
  if (data.device_scope !== undefined && data.device_scope !== device) return false;
  const { applyEventMutex } = await import("./projection");
  return applyEventMutex.runExclusive(async () => {
    if (creditAlertObservationPaused() || observationEpoch !== creditAlertObservationEpoch())
      return false;
    const db = await getDb();
    if (!(await canReceive(db, data.vault_id))) return false;
    const relation = await db.getFirstAsync<{ person_id: string }>(
      `SELECT r.user_b_id AS person_id FROM relationships r JOIN users u ON u.id=r.user_b_id
       WHERE r.id=? AND r.vault_id=? AND r.archived_at IS NULL AND u.archived_at IS NULL`,
      data.relationship_id,
      data.vault_id,
    );
    if (!relation || relation.person_id !== data.person_id || owner !== notificationOwnerScope())
      return false;
    const policy = await readEffectiveCreditAlertPolicy(data.relationship_id, data.vault_id);
    if (!policy?.groups.some((group) => group.direction === data.direction)) return false;
    if (data.policy_updated_at_ms !== undefined) {
      const announced = Number(data.policy_updated_at_ms);
      if (!Number.isSafeInteger(announced) || announced < 0 || policy.updated_at_ms > announced)
        return false;
    }
    if (data.device_scope !== undefined) {
      if (fingerprint(policy, data.direction) !== data.rule_fingerprint) return false;
      const balances = await creditAlertBalancesInTx(
        db,
        data.vault_id,
        data.relationship_id,
        policy.groups,
      );
      if (evaluateCreditAlertDirection(policy, balances, data.direction) !== "matched")
        return false;
      const row = {
        vault_id: data.vault_id,
        relationship_id: data.relationship_id,
      } as CreditAlertCustomer;
      const latch = await readLatch(db, latchKey(owner, device, row, data.direction));
      if (
        latch?.state !== "matched" ||
        latch.event_key !== data.event_key ||
        latch.fingerprint !== data.rule_fingerprint
      )
        return false;
    }
    return (
      owner === notificationOwnerScope() &&
      !creditAlertObservationPaused() &&
      observationEpoch === creditAlertObservationEpoch()
    );
  });
}

async function observe(owner: string, device: string, current: () => boolean): Promise<Notice[]> {
  const { applyEventMutex } = await import("./projection");
  return applyEventMutex.runExclusive(async () => {
    const db = await getDb();
    const notices: Notice[] = [];
    await db.withTransactionAsync(async () => {
      const customers = await listEffectiveCreditAlertCustomers();
      const access = new Map<string, boolean>();
      const liveKeys = new Set<string>();
      for (const row of customers) {
        if (!current()) throw new Error("credit_alert_scope_changed");
        if (!access.has(row.vault_id)) access.set(row.vault_id, await canReceive(db, row.vault_id));
        if (!access.get(row.vault_id)) continue;
        const balances = await creditAlertBalancesInTx(
          db,
          row.vault_id,
          row.relationship_id,
          row.policy.groups,
        );
        for (const direction of ["collect", "pay"] as const) {
          const key = latchKey(owner, device, row, direction);
          liveKeys.add(key);
          const semanticFingerprint = fingerprint(row.policy, direction);
          const previous = await readLatch(db, key);
          const result = advanceCreditAlertLatch(
            previous,
            semanticFingerprint,
            evaluateCreditAlertDirection(row.policy, balances, direction),
          );
          if (result.crossing) {
            result.latch.event_key = hash(
              JSON.stringify([
                owner,
                device,
                row.vault_id,
                row.relationship_id,
                direction,
                semanticFingerprint,
                result.latch.sequence,
              ]),
            );
            notices.push({
              ...row,
              direction,
              fingerprint: semanticFingerprint,
              event_key: result.latch.event_key,
              owner,
              device,
            });
          }
          // Persist before delivery: a restart, refused native request or mute
          // cannot replay an already-observed crossing as a fresh episode.
          if (JSON.stringify(previous) !== JSON.stringify(result.latch))
            await db.runAsync(
              "INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              key,
              JSON.stringify(result.latch),
            );
        }
      }
      // Removed overrides, archived customers and revoked access do not leave
      // a prior episode armed if the same rule is added again later.
      const old = await db.getAllAsync<{ key: string }>(
        "SELECT key FROM app_meta WHERE key LIKE ?",
        latchScope(owner, device) + "%",
      );
      for (const row of old)
        if (!liveKeys.has(row.key)) await db.runAsync("DELETE FROM app_meta WHERE key=?", row.key);
      if (!current()) throw new Error("credit_alert_scope_changed");
    });
    return notices;
  });
}

function noticeData(notice: Notice): AlertData {
  return {
    kind: "credit_alert",
    owner_scope: notice.owner,
    device_scope: notice.device,
    vault_id: notice.vault_id,
    relationship_id: notice.relationship_id,
    person_id: notice.person_id,
    direction: notice.direction,
    rule_fingerprint: notice.fingerprint,
    event_key: notice.event_key,
  };
}

/** Observe committed financial state, then deliver permitted new crossings.
 * This does not prompt for permission or create/modify a financial record. */
export function reconcileCreditAlertNotifications(): Promise<void> {
  const request = generation;
  const observationEpoch = creditAlertObservationEpoch();
  const owner = notificationOwnerScope();
  const install = getInstallIdSync();
  const current = () =>
    request === generation &&
    !creditAlertObservationPaused() &&
    observationEpoch === creditAlertObservationEpoch() &&
    owner === notificationOwnerScope() &&
    install === getInstallIdSync();
  const run = async () => {
    if (!current()) return;
    // Reuse the private THIS_DEVICE_ONLY key: an OS/database backup copied to
    // another phone starts fresh rather than inheriting this phone's latch.
    const device = await getReminderDeviceId();
    if (!current()) return;
    // Transport maintenance must never hold local/offline observations behind
    // token acquisition or an unavailable server. Confirmed ownership persists.
    void syncCreditAlertPushSubscriptions().catch(() => undefined);
    const notices = await observe(owner, device, current);
    const n = await native();
    if (!n || !current()) return;
    for (const shown of await n.getPresentedNotificationsAsync()) {
      if (!current()) return;
      const data = shown.request.content.data;
      if (data?.kind !== "credit_alert") continue;
      // Remote tray text is always generic. Clear it on launch/account change;
      // otherwise its tap performs authenticated resolution. Do not serialize
      // local/offline delivery behind a network lookup for every tray item.
      if (typeof data.device_scope !== "string") {
        if (purgeRemoteTray) await n.dismissNotificationAsync(shown.request.identifier);
        continue;
      }
      const contact = parseData(data);
      const policy = contact
        ? await notificationPolicyForContact({
            vaultId: contact.vault_id,
            personId: contact.person_id,
          })
        : null;
      if (!current()) return;
      if (
        !policy ||
        !notificationAllowed(policy, "credit_alert") ||
        !(await creditAlertNoticeAllowed(data)) ||
        (contact?.device_scope !== undefined && contact.policy_key !== hash(JSON.stringify(policy)))
      )
        await n.dismissNotificationAsync(shown.request.identifier);
    }
    if (current()) purgeRemoteTray = false;
    const permission = await n.getPermissionsAsync();
    if (
      !current() ||
      !(permission.granted || permission.ios?.status === n.IosAuthorizationStatus.PROVISIONAL)
    )
      return;
    for (const notice of notices) {
      // Synced policies have one authority for native delivery. The server
      // announces its own accepted state, even for writes from this phone.
      if (!notice.sync_pending && (await creditAlertRemoteDeliveryActive(notice.vault_id)))
        continue;
      const revision = notificationPreferencesRevision();
      const policy = await notificationPolicyForContact({
        vaultId: notice.vault_id,
        personId: notice.person_id,
      });
      if (!current()) return;
      if (
        !notificationAllowed(policy, "credit_alert") ||
        (AppState.currentState === "active" && !policy.foreground)
      )
        continue;
      const data = noticeData(notice);
      data.policy_key = hash(JSON.stringify(policy));
      if (!(await creditAlertNoticeAllowed(data)) || !current()) continue;
      const customer = await (
        await getDb()
      ).getFirstAsync<{ name: string }>(
        "SELECT display_name AS name FROM users WHERE id=? AND archived_at IS NULL",
        notice.person_id,
      );
      if (!current() || revision !== notificationPreferencesRevision()) continue;
      if (Platform.OS === "android" && configuredLocale !== getLocale()) {
        for (const sound of [false, true])
          for (const vibration of [false, true])
            await n.setNotificationChannelAsync(channel({ sound, vibration }), {
              name: t("creditAlerts.notify.channel"),
              importance: n.AndroidImportance.DEFAULT,
              sound: sound ? "default" : null,
              enableVibrate: vibration,
              vibrationPattern: vibration ? [0, 250, 250, 250] : [],
            });
        configuredLocale = getLocale();
      }
      if (!current() || revision !== notificationPreferencesRevision()) continue;
      const name = customer?.name.trim();
      const body =
        policy.previews === "private"
          ? t("notificationSettings.alert.private")
          : name
            ? t(
                notice.direction === "collect"
                  ? "creditAlerts.notify.collectNamed"
                  : "creditAlerts.notify.payNamed",
                { name },
              )
            : t(
                notice.direction === "collect"
                  ? "creditAlerts.notify.collect"
                  : "creditAlerts.notify.pay",
              );
      const identifier = PREFIX + notice.event_key;
      await n.scheduleNotificationAsync({
        identifier,
        content: {
          title: "Kaata",
          body,
          sound: policy.sound ? "default" : undefined,
          vibrate: policy.vibration ? [0, 250, 250, 250] : [],
          data,
        },
        trigger: Platform.OS === "android" ? { channelId: channel(policy) } : null,
      });
      if (
        !current() ||
        revision !== notificationPreferencesRevision() ||
        !(await creditAlertNoticeAllowed(data))
      ) {
        await n.dismissNotificationAsync(identifier).catch(() => undefined);
        await n.cancelScheduledNotificationAsync(identifier).catch(() => undefined);
      }
    }
  };
  const work = tail.then(run, run);
  tail = work.catch(() => undefined);
  return work;
}

/** Lifecycle is owned by RootLayout after database boot, independently of
 * cloud scheduler enrollment. Coalesce bursts into one complete observation. */
export function startCreditAlertNotifications(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (stopped) return;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void reconcileCreditAlertNotifications().catch(() => undefined);
    }, 150);
  };
  const invalidate = () => {
    generation++;
    schedule();
  };
  const stopLedger = onLedgerApplied(schedule);
  const stopTabs = onTabApplied(schedule);
  const stopPolicies = onCreditPoliciesChanged(schedule);
  const stopIdentity = onAccountIdentityChanged(() => {
    purgeRemoteTray = true;
    invalidate();
    void syncCreditAlertPushSubscriptions(true).catch(() => undefined);
  });
  const stopPreferences = onNotificationPreferencesChanged(() => {
    invalidate();
    void syncCreditAlertPushSubscriptions(true).catch(() => undefined);
  });
  const stopLocale = subscribeLocale(() => {
    invalidate();
    void syncCreditAlertPushSubscriptions(true).catch(() => undefined);
  });
  const stopRestore = onCreditAlertObservationResumed(schedule);
  const foreground = AppState.addEventListener("change", (state) => {
    if (state === "active") schedule();
  });
  schedule();
  return () => {
    stopped = true;
    generation++;
    if (timer != null) clearTimeout(timer);
    stopLedger();
    stopTabs();
    stopPolicies();
    stopIdentity();
    stopPreferences();
    stopLocale();
    stopRestore();
    foreground.remove();
  };
}

/** Resolve the current customer from the relationship and verify access twice;
 * the untrusted payload can never navigate into another account's cache. */
export async function openCreditAlertNotification(
  value: unknown,
  canOpen: () => boolean = () => true,
): Promise<void> {
  const data = await resolveCreditAlertNotificationData(value);
  if (!data || !canOpen()) return;
  const owner = notificationOwnerScope();
  const tap = ++latestTap;
  let switched = false;
  const stop = onAccountIdentityChanged(() => {
    switched = true;
  });
  const current = () =>
    canOpen() && !switched && tap === latestTap && owner === notificationOwnerScope();
  try {
    if (data.device_scope === undefined) {
      // A remote notice can precede this phone's first copy of its customer or
      // rule. Refresh the server-authorized target before applying local read
      // gates; configuration refresh preserves unpublished explicit overrides.
      const session = await captureCurrentSession();
      if (!current()) return;
      const vault = await (
        await getDb()
      ).getFirstAsync<{ id: string }>(
        "SELECT id FROM vaults WHERE id=? AND archived_at IS NULL",
        data.vault_id,
      );
      if (!current()) return;
      if (!vault) {
        const { recoverJoinedVault } = await import("./recovery");
        await recoverJoinedVault(data.vault_id, session);
      }
      if (!current()) return;
      const { pullEvents } = await import("./sync/pull");
      await pullEvents(data.vault_id, session);
      if (!current()) return;
      const { refreshCreditAlerts } = await import("./credit-alerts");
      await refreshCreditAlerts(data.vault_id, session);
      if (!current()) return;
    }
    if (!(await creditAlertNoticeAllowed(data)) || !current()) return;
    await setActiveVaultId(data.vault_id);
    if (!current()) return;
    const { applyVaultCurrency } = await import("./currency");
    await applyVaultCurrency(data.vault_id);
    if (!current() || !(await creditAlertNoticeAllowed(data)) || !current()) return;
    const { router } = await import("expo-router");
    if (current()) router.push({ pathname: "/person/[id]", params: { id: data.person_id } });
  } finally {
    stop();
  }
}
