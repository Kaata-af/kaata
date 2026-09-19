// apps/mobile/lib/mesh/bg-notify.ts
//
// #46 — per-sync notification. When a SYNCED (remote-origin) ledger event is
// applied while the app is NOT in the foreground, post a local notification so
// the shopkeeper knows new entries arrived — without opening the app.
//
// Originally written for the Briar-style nearby-phone mesh; with the mesh
// parked, the live producer is CLOUD sync — lib/sync pulls events and applies
// them through lib/projection with origin "remote", which is what fires
// onLedgerApplied here. It is what a shopkeeper with a second device sees.
//
// Uses expo-notifications. It previously used @notifee/react-native, which was
// ARCHIVED in April 2026 (9.1.8 is the final release that will ever exist) and
// is a legacy-bridge module: its Android headless path calls
// ReactApplication.getReactNativeHost(), which React Native 0.83 makes throw and
// which Expo SDK 55's MainApplication no longer overrides. expo-notifications
// was already a dependency and already configured in app.json, so this cost one
// call site to remove an entire dead-upstream native dependency.
//
// Subscribes at module load (imported from index.js after the polyfills) so the
// subscription exists in BOTH the foreground VM (when backgrounded) and the
// headless VM. The onLedgerApplied listener set is per-VM; whichever VM applied
// the synced event fires its own listener.
import { AppState, Platform } from "react-native";
import { isRunningInExpoGo } from "expo";

import { getAppMeta } from "../db";
import { getDb } from "../db-tx";
import { onLedgerApplied } from "../ledger-events";

const CHANNEL_ID = "ledger-updates";
// Coalesce a sync batch (and a burst of vaults) into one notification.
const DEBOUNCE_MS = 3000;

// expo-notifications is loaded LAZILY, and in Expo Go not at all.
//
// Importing it has a side effect that THROWS on Android under Expo Go:
// DevicePushTokenAutoRegistration.fx registers a push-token listener at module
// scope, and since SDK 53 expo-notifications throws from that registration
// because Expo Go dropped remote-push support. Since THIS file is imported from
// index.js, before any UI exists, a static import took the entire app down at
// boot with a red screen the moment anyone opened it in Expo Go — for a feature
// that posts purely LOCAL notifications and never asks for a push token.
//
// Two guards, because either alone would be fragile. Expo Go skips the
// subscription outright, since there is nothing it could deliver there. And
// everywhere else the import is deferred to the first synced event that
// actually needs to notify, so the cost never lands on startup. Development
// builds and store builds behave exactly as before.
type NotificationsModule = typeof import("expo-notifications");
let notificationsPromise: Promise<NotificationsModule> | null = null;

async function loadNotifications(): Promise<NotificationsModule | null> {
  if (isRunningInExpoGo()) return null;
  if (!notificationsPromise) {
    notificationsPromise = import("expo-notifications").catch((err) => {
      // Clear the cached rejection so a transient failure can be retried on the
      // next sync instead of silencing notifications for the whole process.
      notificationsPromise = null;
      throw err;
    });
  }
  return notificationsPromise;
}

let channelReady = false;
const pendingVaults = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureChannel(notifications: NotificationsModule): Promise<void> {
  if (channelReady) return;
  await notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "Synced updates",
    importance: notifications.AndroidImportance.DEFAULT,
    description: "New entries synced from your account while Kaata was in the background.",
  });
  channelReady = true;
}

async function shopName(vaultId: string): Promise<string | null> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ shop_name: string }>(
      "SELECT shop_name FROM shop_profile WHERE vault_id = ? LIMIT 1",
      vaultId,
    );
    return row?.shop_name?.trim() || null;
  } catch {
    return null;
  }
}

async function flush(): Promise<void> {
  flushTimer = null;
  const vaults = Array.from(pendingVaults);
  pendingVaults.clear();
  if (vaults.length === 0) return;
  // Opt-out (default ON). Lets the user silence it from Settings later without a
  // build, and the channel is user-mutable in the OS too.
  if ((await getAppMeta("bg_notify_enabled")) === "0") return;

  const notifications = await loadNotifications().catch(() => null);
  if (!notifications) return;

  try {
    await ensureChannel(notifications);
  } catch {
    return;
  }

  let title = "New entries synced";
  let body = "Tap to open Kaata";
  if (vaults.length === 1) {
    const name = await shopName(vaults[0]);
    if (name) {
      title = name;
      body = "New entries synced — tap to open";
    }
  }

  try {
    // trigger is the CHANNEL-AWARE form, not null. Both deliver immediately, but
    // `null` drops the notification onto expo-notifications' auto-created
    // "Miscellaneous" fallback channel — so the user's mute/importance settings
    // for "Synced updates" would silently not apply to it.
    //
    // The small icon and accent colour come from the expo-notifications config
    // plugin in app.json; there is no per-notification icon option.
    await notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: { channelId: CHANNEL_ID },
    });
  } catch (err) {
    if (__DEV__) console.warn("[bg-notify] scheduleNotificationAsync failed", err);
  }
}

if (Platform.OS === "android" && !isRunningInExpoGo()) {
  onLedgerApplied((vaultId, origin) => {
    // Only SYNCED entries (not the user's own local writes), and only when the
    // user isn't actively looking at the app. In the headless VM AppState is
    // always "background", so it correctly fires there too.
    if (origin !== "remote") return;
    if ((AppState.currentState as string) === "active") return;
    pendingVaults.add(vaultId);
    if (flushTimer == null) flushTimer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });
}
